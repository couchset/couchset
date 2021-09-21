import camelCase from 'lodash/camelCase';
import gql from 'graphql-tag';
import {ResTypeFragment} from '@stoqey/client-graphql';
import {isEmpty} from 'lodash';

interface Props {
    name: string;
    fields: string[];
}

export const generateClient = (props: Props) => {
    // TODO inner fragments
    // TODO fields mapping
    const {name, fields} = props;

    const nameCamel = camelCase(name);
    const fragmentName = `${name}Fragment`;

    const fieldsJoined = (fields || []).join(',');

    const FRAGMENT = isEmpty(fields)
        ? null
        : gql`
    fragment ${fragmentName} on ${name} {
        ${fieldsJoined}
    }
  `;

    const PAGE = gql`
    query Page${name}($id: String!) {
        data: ${nameCamel}Pagination(id: $id) {
            ...${fragmentName}
        }
    }
    ${FRAGMENT}
  `;

    const GET = gql`
    query Get${name}($id: String!) {
      data: ${nameCamel}Get(id: $id) {
        ...${fragmentName}
      }
    }
    ${FRAGMENT}
  `;

    const DELETE = gql`
     mutation Delete${name}($id: String!) {
        data: ${nameCamel}Delete(id: $id) {
            ...ResTypeFragment
        }
     }
    ${ResTypeFragment}
   `;

    const CREATE = gql`
    mutation Create${name}($args: ${name}Input!) {
        data: ${nameCamel}Create(args: $args) {
            ...ResTypeFragment
        }
    }
    ${ResTypeFragment}
   `;

    return {FRAGMENT, GET, DELETE, CREATE, PAGE};
};
